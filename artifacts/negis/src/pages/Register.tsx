import React, { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import { trackEvent } from '@/lib/fbpixel';
import { ArrowLeft } from 'lucide-react';

const registerSchema = z.object({
  fullName: z.string().min(2, 'Обязательное поле'),
  clinicName: z.string().min(2, 'Обязательное поле'),
  email: z.string().email('Неверный формат email'),
  password: z.string().min(8, 'Пароль должен быть не менее 8 символов'),
  confirmPassword: z.string()
}).refine((data) => data.password === data.confirmPassword, {
  message: "Пароли не совпадают",
  path: ["confirmPassword"],
});

type RegisterFormValues = z.infer<typeof registerSchema>;

export default function Register() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema)
  });

  const onSubmit = async (data: RegisterFormValues) => {
    setIsLoading(true);
    try {
      // 1. SignUp
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: data.email,
        password: data.password,
        options: {
          data: {
            full_name: data.fullName,
          }
        }
      });

      if (authError) throw authError;
      if (!authData.user) throw new Error('Не удалось создать пользователя');

      // 2. Insert Clinic
      const { data: clinicData, error: clinicError } = await supabase
        .from('clinics')
        .insert({
          name: data.clinicName,
          owner_id: authData.user.id
        })
        .select()
        .single();

      if (clinicError) throw clinicError;

      // 3. Insert user_roles
      const { error: roleError } = await supabase
        .from('user_roles')
        .insert({
          user_id: authData.user.id,
          clinic_id: clinicData.id,
          role: 'owner'
        });

      if (roleError) throw roleError;

      toast.success('Клиника успешно зарегистрирована!');
      trackEvent('CompleteRegistration');
      setLocation('/onboarding');
      
    } catch (error: any) {
      console.error(error);
      toast.error(error.message || 'Ошибка регистрации');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#E8EDF2] flex items-center justify-center p-4">
      <div className="neu-lg w-full max-w-md p-8 bg-[#E8EDF2]">
        <Link href="/" className="inline-flex items-center text-sm font-medium text-[#64748B] hover:text-[#1A56DB] mb-6 transition-colors">
          <ArrowLeft size={16} className="mr-1" />
          На главную
        </Link>
        
        <h2 className="text-2xl font-bold text-center mb-8 text-foreground">Регистрация клиники</h2>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <input 
              type="text" 
              placeholder="Имя владельца" 
              className="neu-input" 
              {...register('fullName')}
            />
            {errors.fullName && <p className="text-destructive text-xs mt-1 px-2">{errors.fullName.message}</p>}
          </div>

          <div>
            <input 
              type="text" 
              placeholder="Название клиники" 
              className="neu-input" 
              {...register('clinicName')}
            />
            {errors.clinicName && <p className="text-destructive text-xs mt-1 px-2">{errors.clinicName.message}</p>}
          </div>

          <div>
            <input 
              type="email" 
              placeholder="Email" 
              className="neu-input" 
              {...register('email')}
            />
            {errors.email && <p className="text-destructive text-xs mt-1 px-2">{errors.email.message}</p>}
          </div>

          <div>
            <input 
              type="password" 
              placeholder="Пароль (мин 8 символов)" 
              className="neu-input" 
              {...register('password')}
            />
            {errors.password && <p className="text-destructive text-xs mt-1 px-2">{errors.password.message}</p>}
          </div>

          <div>
            <input 
              type="password" 
              placeholder="Подтверждение пароля" 
              className="neu-input" 
              {...register('confirmPassword')}
            />
            {errors.confirmPassword && <p className="text-destructive text-xs mt-1 px-2">{errors.confirmPassword.message}</p>}
          </div>

          <button 
            type="submit" 
            className="neu-btn-primary w-full justify-center mt-6"
            disabled={isLoading}
          >
            {isLoading ? 'Регистрация...' : 'Зарегистрировать'}
          </button>
        </form>
      </div>
    </div>
  );
}
